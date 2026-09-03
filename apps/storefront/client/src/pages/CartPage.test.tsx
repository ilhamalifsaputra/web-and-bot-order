import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { render, screen, within, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import CartPage from "./CartPage";
import { apiGet, apiPost } from "../api/client";
import type { CartPageData, ShelfPageData, ShopContext } from "../api/types";
import type { ProductCardData } from "../components/shop/ProductCard";

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
  wa_number: null,
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
      delivery_type: "auto",
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

  // Removal now takes two taps: the trash icon only opens an inline
  // confirmation, and the confirm button inside it is what posts.
  it("removing a line posts remove and empties the cart", async () => {
    renderCart(() => cartData);
    await screen.findByRole("heading", { name: "Cart (4)" });
    (apiPost as Mock).mockResolvedValue({ items: [], subtotal: "0" });
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Remove this item from your cart?");
    expect(apiPost).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/v1/cart/remove", { key: 10 }));
    expect(await screen.findByText("Your cart is empty — browse the products.")).toBeInTheDocument();
    // Points at /products, not the homepage: a button labelled "Browse
    // products" had nowhere better to go before that page existed.
    expect(screen.getByRole("link", { name: "Browse products" })).toHaveAttribute("href", "/products");
  });

  it("cancelling the remove confirmation leaves the line and its controls alone", async () => {
    renderCart(() => cartData);
    await screen.findByRole("heading", { name: "Cart (4)" });
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(apiPost).not.toHaveBeenCalled();
    expect(screen.getByText("Netflix Premium - 1 Month")).toBeInTheDocument();
    // The confirmation replaces the quantity controls, so cancelling has to
    // bring them back — otherwise the row is left unusable.
    expect(screen.getByLabelText("Quantity")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update" })).toBeInTheDocument();
  });

  // Phones show a QWERTY keyboard for type="number" unless inputMode says
  // otherwise, which is a poor way to type a digit into a 64px field.
  it("hints a numeric keypad on the quantity field", async () => {
    renderCart(() => cartData);
    await screen.findByRole("heading", { name: "Cart (4)" });
    expect(screen.getByLabelText("Quantity")).toHaveAttribute("inputmode", "numeric");
  });

  // jsdom has no matchMedia, so useIsDesktop() reports mobile — this is the
  // small-screen layout: checkout is reachable from the sticky bar, and the
  // summary card drops its own copy of the link so there is only ever one.
  // The sticky bar's CTA is StickyPurchaseBar's button-based primary action
  // (Fase 7c — the bar has no Link variant), not a literal <a>, so this now
  // looks for a button rather than a link; the destination (navigate
  // ("/checkout")) and the "exactly one control" property are unchanged.
  it("puts the checkout call to action in a single reachable place on mobile", async () => {
    renderCart(() => cartData);
    await screen.findByRole("heading", { name: "Cart (4)" });
    expect(screen.queryAllByRole("link", { name: /Continue to payment/ })).toHaveLength(0);
    const checkoutButtons = screen.getAllByRole("button", { name: /Continue to payment/ });
    expect(checkoutButtons).toHaveLength(1);
  });

  it("renders the empty-cart branch when the cart starts empty", async () => {
    renderCart(() => ({ items: [], subtotal: "0" }));
    expect(await screen.findByText("Your cart is empty — browse the products.")).toBeInTheDocument();
    expect(screen.queryByText("Summary")).not.toBeInTheDocument();
  });

  // E3: a stepper reading "1 · Cart → 2 · Payment → 3 · Done" above an empty
  // state implies a checkout in progress when there's nothing to check out.
  it("hides the checkout stepper when the cart is empty", async () => {
    renderCart(() => ({ items: [], subtotal: "0" }));
    await screen.findByText("Your cart is empty — browse the products.");
    expect(screen.queryByRole("listitem", { name: "1 · Cart" })).not.toBeInTheDocument();
  });

  it("shows the checkout stepper on step 1 while the cart has items", async () => {
    renderCart(() => cartData);
    await screen.findByRole("heading", { name: "Cart (4)" });
    expect(screen.getByRole("listitem", { name: "1 · Cart" })).toHaveAttribute("aria-current", "step");
  });

  it("hides the stepper once the last line is removed", async () => {
    renderCart(() => cartData);
    await screen.findByRole("heading", { name: "Cart (4)" });
    expect(screen.getByRole("listitem", { name: "1 · Cart" })).toBeInTheDocument();
    (apiPost as Mock).mockResolvedValue({ items: [], subtotal: "0" });
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await screen.findByText("Your cart is empty — browse the products.");
    expect(screen.queryByRole("listitem", { name: "1 · Cart" })).not.toBeInTheDocument();
  });

  // Task 10 (E4): an empty cart is one of the pages where shopping IS the
  // next step, so the shelf fetch fires (unlike SupportPage/the checkout
  // error state, which stay shelf-free on purpose).
  it("shows a suggested-products shelf once it loads, without delaying the empty-cart card", async () => {
    const suggestedProduct: ProductCardData = {
      slug: "spotify-premium",
      name: "Spotify Premium",
      category_name: "Streaming",
      from_price: "45000",
      variant_count: 1,
      image: "",
      available: 3,
      rating: null,
      rating_count: 0,
      bulk_discount: null,
      bulk_min_qty: null,
      all_non_auto: false,
    };
    const shelf: ShelfPageData = { products: [suggestedProduct], low_threshold: 5 };
    (apiGet as Mock).mockImplementation(async (path: string) => {
      if (path === "/api/v1/pages/context") return context;
      if (path === "/api/v1/pages/suggestions") return shelf;
      return { items: [], subtotal: "0" };
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/cart"]}>
          <Routes>
            <Route path="/cart" element={<CartPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    // The empty-cart card is there before the shelf even could be — same
    // request wave, but the card renders off `cart`, not off `suggested`.
    expect(await screen.findByText("Your cart is empty — browse the products.")).toBeInTheDocument();
    expect(await screen.findByText("You might also like")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Spotify Premium/ })).toHaveAttribute("href", "/p/spotify-premium");
  });

  it("shows the login-to-checkout hint for a guest without singling out Telegram (STO-009)", async () => {
    renderCart(() => cartData);
    expect(await screen.findByText("Sign in to continue — your cart comes along.")).toBeInTheDocument();
  });

  // STO-008: the cart previously offered only "Continue to payment", with no
  // way back to browsing.
  it("offers a Continue shopping link back to the homepage", async () => {
    renderCart(() => cartData);
    await screen.findByRole("heading", { name: "Cart (4)" });
    expect(screen.getByRole("link", { name: "Continue shopping" })).toHaveAttribute("href", "/");
  });

  // Flash sales: `unit_price` on the line is ALREADY the sale price, so the
  // line only adds the ⚡ badge and the struck-through pre-sale figure.
  it("shows the flash badge and struck-through base price on a discounted line", async () => {
    const endsAt = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
    const onSale: CartPageData = {
      items: [
        {
          ...cartData.items[0]!,
          unit_price: "63200",
          line_total: "126400",
          flash: { discount_percent: "20", base_price: "79000", ends_at: endsAt },
        },
      ],
      subtotal: "126400",
    };
    renderCart(() => onSale);
    await screen.findByRole("heading", { name: "Cart (4)" });
    expect(screen.getByText(/Flash sale/)).toHaveTextContent("20%");
    expect(screen.getByText("Was Rp79.000")).toBeInTheDocument();
    expect(screen.getAllByText("Rp63.200").length).toBeGreaterThan(0);
  });

  it("shows no flash badge or struck-through price on a line with no sale", async () => {
    renderCart(() => cartData);
    await screen.findByRole("heading", { name: "Cart (4)" });
    expect(screen.queryByText(/Flash sale/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Was /)).not.toBeInTheDocument();
  });

  // Bug B (Task 6): non-auto lines never have stock rows by design (available
  // is always 0), so `qty > available` was ALWAYS true for a legitimate
  // manual/manual_with_info cart line — the "N left" warning must be
  // suppressed for those, not driven by the meaningless available count.
  it("does not show the stock-shortage warning for a non-auto line even though qty > available", async () => {
    const manualCart: CartPageData = {
      items: [{ ...cartData.items[0]!, delivery_type: "manual", available: 0, qty: 3 }],
      subtotal: "237000",
    };
    renderCart(() => manualCart);
    await screen.findByRole("heading", { name: "Cart (4)" });
    expect(screen.queryByText(/left$/)).not.toBeInTheDocument();
  });
});
